require 'calc'

RSpec.describe Calc do
  describe '.add' do
    [[2, 3, 5], [0, 0, 0]].each do |a, b, want|
      it "adds #{a} and #{b}" do
        expect(Calc.add(a, b)).to eq(want)
      end
    end
  end
end
